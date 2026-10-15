Shader "FindFXTests/Particle"
{
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" }
        Pass
        {
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off
            CGPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #include "UnityCG.cginc"

            struct Vertex
            {
                float4 position : POSITION;
                fixed4 color : COLOR;
            };

            struct Interpolators
            {
                float4 position : SV_POSITION;
                fixed4 color : COLOR;
            };

            Interpolators Vert(Vertex input)
            {
                Interpolators output;
                output.position = UnityObjectToClipPos(input.position);
                output.color = input.color;
                return output;
            }

            fixed4 Frag(Interpolators input) : SV_Target
            {
                // A predictable time ramp also verifies the offline shader clock.
                return input.color * fixed4(0.2 + 0.8 * saturate(_Time.y / 3.0), 0.6, 0.2, 1.0);
            }
            ENDCG
        }
    }
}
